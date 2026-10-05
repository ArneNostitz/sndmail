//! Desktop notifications that carry buttons.
//!
//! `tauri-plugin-notification` hands its text to `notify-rust` on desktop. On
//! macOS that is the legacy `NSUserNotification` path, which knows nothing of
//! categories, so a notification can never carry a button — and the plugin's
//! `registerActionTypes`/`onAction` are mobile-only no-ops, which is why the
//! Reply and Archive actions snd registered for years never appeared.
//!
//! Buttons on a Mac need `UNUserNotificationCenter`: a *category* names a set
//! of buttons, a notification names its category, and a delegate hears which
//! button was pressed. That is what this module does. Each notification also
//! carries its own context (thread, account, code, link) in `userInfo`, so a
//! press on the third of five stacked notifications acts on the third — the
//! old "last context wins" could not.
//!
//! Two limits, both the platform's: the centre refuses a process that is not
//! an app bundle (a bare `tauri dev` binary throws
//! `NSInternalInconsistencyException`), so `available()` says no there and
//! the frontend keeps the plugin path; and macOS shows the buttons of a
//! *banner* only on hover — `NSUserNotificationAlertStyle = alert` in
//! `Info.plist` asks for the alert style by default, and the user can change
//! it either way in System Settings.
//!
//! Other platforms: every command reports unavailability and the frontend
//! shows plain text through the plugin, as before.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Event carrying a [`NotificationResponse`] to the webview.
pub const ACTION_EVENT: &str = "snd-notification-action";

/// `action_id` for a click on the notification body.
pub const DEFAULT_ACTION: &str = "default";
/// `action_id` for a notification the user swiped away.
pub const DISMISS_ACTION: &str = "dismiss";

const UNAVAILABLE: &str = "Native notifications are not available on this platform";

/// One button.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub id: String,
    pub title: String,
    /// Bring the app to the front when pressed (reply, open a link).
    #[serde(default)]
    pub foreground: bool,
    /// Drawn in red.
    #[serde(default)]
    pub destructive: bool,
}

/// A named set of buttons a notification can ask for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationCategory {
    pub id: String,
    pub actions: Vec<NotificationAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    pub title: String,
    pub body: String,
    /// Which button set to attach; none means a plain notification.
    #[serde(default)]
    pub category_id: Option<String>,
    /// Handed back untouched with a press, so the handler knows what the
    /// notification was about without keeping a table of its own.
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    /// Notifications sharing a group stack together in Notification Centre.
    #[serde(default)]
    pub group: Option<String>,
}

/// What the user did with a notification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationResponse {
    /// The pressed button's id, [`DEFAULT_ACTION`] for a click on the body,
    /// [`DISMISS_ACTION`] for a swipe-away.
    pub action_id: String,
    pub notification_id: String,
    pub context: Option<serde_json::Value>,
}

#[tauri::command]
pub fn notification_native_available() -> bool {
    imp::available()
}

/// Ask macOS for permission. The first call shows the system prompt; later
/// calls answer from the stored decision.
#[tauri::command]
pub async fn notification_native_request_permission() -> Result<bool, String> {
    imp::request_permission().await
}

#[tauri::command]
pub fn notification_native_register_categories(
    categories: Vec<NotificationCategory>,
) -> Result<(), String> {
    imp::register_categories(categories)
}

/// Show a notification; resolves with its identifier once the centre has
/// accepted it.
#[tauri::command]
pub async fn notification_native_show(request: NotificationRequest) -> Result<String, String> {
    imp::show(request).await
}

/// The webview is listening for [`ACTION_EVENT`]. Returns any presses that
/// arrived before it was — a click that *launched* snd is delivered to the
/// delegate long before the frontend exists.
#[tauri::command]
pub fn notification_native_ready() -> Vec<NotificationResponse> {
    inbox::ready()
}

/// Install the delegate. Must run before the app finishes launching, or a
/// press that launched the app is lost; Tauri's `setup` is early enough.
pub fn install(app: AppHandle) {
    imp::install(app);
}

/// Presses that arrived before the webview was listening.
mod inbox {
    use super::{NotificationResponse, ACTION_EVENT};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    struct Inbox {
        ready: bool,
        pending: Vec<NotificationResponse>,
    }

    static INBOX: Mutex<Inbox> = Mutex::new(Inbox {
        ready: false,
        pending: Vec::new(),
    });

    /// Hand back the response if the webview can take it now; keep it otherwise.
    pub fn accept(response: NotificationResponse) -> Option<NotificationResponse> {
        let mut inbox = INBOX.lock().unwrap_or_else(|e| e.into_inner());
        if inbox.ready {
            Some(response)
        } else {
            inbox.pending.push(response);
            None
        }
    }

    pub fn deliver(app: &AppHandle, response: NotificationResponse) {
        if let Some(response) = accept(response) {
            if let Err(e) = app.emit(ACTION_EVENT, &response) {
                log::warn!("Could not hand a notification press to the webview: {e}");
            }
        }
    }

    pub fn ready() -> Vec<NotificationResponse> {
        let mut inbox = INBOX.lock().unwrap_or_else(|e| e.into_inner());
        inbox.ready = true;
        std::mem::take(&mut inbox.pending)
    }
}

#[cfg(target_os = "macos")]
#[allow(non_snake_case)]
mod imp {
    use super::{
        NotificationAction, NotificationCategory, NotificationRequest, NotificationResponse,
        DEFAULT_ACTION, DISMISS_ACTION, UNAVAILABLE,
    };
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{
        NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationAction as UNAction, UNNotificationActionOptions, UNNotificationCategory,
        UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
        UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest as UNRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;

    /// The one `userInfo` key: the request's context as JSON. A string is a
    /// property-list type, which is all `userInfo` admits, and it spares
    /// translating arbitrary JSON into NSDictionary and back.
    const CONTEXT_KEY: &str = "snd";

    struct Ivars {
        app: AppHandle,
    }

    define_class!(
        /// Hears what the user did with a notification and hands it on.
        #[unsafe(super(NSObject))]
        #[name = "SndNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn userNotificationCenter_willPresentNotification_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // Shown even while snd is the frontmost app: a login code
                // arriving while the user reads other mail is still news
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let parsed = parse_response(response);
                super::inbox::deliver(&self.ivars().app, parsed);
                completion.call(());
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { app });
            // SAFETY: NSObject's designated initialiser, on a freshly
            // allocated instance whose ivars are set
            unsafe { msg_send![super(this), init] }
        }
    }

    /// The centre keeps only a weak reference to its delegate; this is the
    /// strong one, held for the life of the process.
    struct Held(#[allow(dead_code)] Retained<Delegate>);
    // SAFETY: after `install` nothing here touches the delegate again; the
    // centre calls it from its own queue, and everything it reaches
    // (`AppHandle`) is Send + Sync.
    unsafe impl Send for Held {}
    unsafe impl Sync for Held {}
    static DELEGATE: OnceLock<Held> = OnceLock::new();
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    pub fn available() -> bool {
        *AVAILABLE.get_or_init(|| {
            // A bare binary (`tauri dev`) has no bundle, and the centre
            // throws rather than erroring when asked for one. Both checks,
            // because `mac-notification-sys` swizzles `bundleIdentifier` to
            // "com.apple.Terminal" the first time the plugin path is used.
            let bundle = NSBundle::mainBundle();
            let bundled = bundle.bundleIdentifier().is_some()
                && bundle.bundlePath().to_string().ends_with(".app");
            // The framework arrived with 10.14; the bundle still admits 10.13
            let framework = AnyClass::get(c"UNUserNotificationCenter").is_some();
            let ok = bundled && framework;
            log::info!(
                "Native notifications {}",
                if ok { "available" } else { "unavailable (not running as an app bundle)" }
            );
            ok
        })
    }

    pub fn install(app: AppHandle) {
        if !available() {
            return;
        }
        let delegate = Delegate::new(app);
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let _ = DELEGATE.set(Held(delegate));
    }

    // Objective-C handles are not `Send`, and a Tauri command's future must
    // be: so every call below does its Objective-C work in a plain function
    // that returns a channel, and only the channel is awaited.

    pub async fn request_permission() -> Result<bool, String> {
        if !available() {
            return Err(UNAVAILABLE.into());
        }
        ask_permission()
            .await
            .map_err(|_| "The notification centre never answered".to_string())?
    }

    fn ask_permission() -> tokio::sync::oneshot::Receiver<Result<bool, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<bool, String>>();
        // A block is `Fn`, so the one-shot sender has to be taken out of it
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let outcome = if error.is_null() {
                Ok(granted.as_bool())
            } else {
                Err(describe(error))
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(outcome);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert
                    | UNAuthorizationOptions::Sound
                    | UNAuthorizationOptions::Badge,
                &handler,
            );
        rx
    }

    pub fn register_categories(categories: Vec<NotificationCategory>) -> Result<(), String> {
        if !available() {
            return Err(UNAVAILABLE.into());
        }
        let built: Vec<Retained<UNNotificationCategory>> =
            categories.iter().map(build_category).collect();
        UNUserNotificationCenter::currentNotificationCenter()
            .setNotificationCategories(&NSSet::from_retained_slice(&built));
        Ok(())
    }

    fn build_action(action: &NotificationAction) -> Retained<UNAction> {
        let mut options = UNNotificationActionOptions::empty();
        if action.foreground {
            options |= UNNotificationActionOptions::Foreground;
        }
        if action.destructive {
            options |= UNNotificationActionOptions::Destructive;
        }
        UNAction::actionWithIdentifier_title_options(
            &NSString::from_str(&action.id),
            &NSString::from_str(&action.title),
            options,
        )
    }

    fn build_category(category: &NotificationCategory) -> Retained<UNNotificationCategory> {
        let actions: Vec<Retained<UNAction>> =
            category.actions.iter().map(build_action).collect();
        UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(&category.id),
            &NSArray::from_retained_slice(&actions),
            &NSArray::<NSString>::new(),
            UNNotificationCategoryOptions::empty(),
        )
    }

    pub async fn show(request: NotificationRequest) -> Result<String, String> {
        if !available() {
            return Err(UNAVAILABLE.into());
        }
        let (id, accepted) = submit(request)?;
        match accepted.await {
            Ok(None) | Err(_) => Ok(id),
            Ok(Some(error)) => Err(error),
        }
    }

    /// Build the notification and hand it to the centre. Returns its id and
    /// a channel that yields the centre's error, if it has one.
    fn submit(
        request: NotificationRequest,
    ) -> Result<(String, tokio::sync::oneshot::Receiver<Option<String>>), String> {
        let id = format!(
            "snd-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&request.title));
        content.setBody(&NSString::from_str(&request.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if let Some(category) = &request.category_id {
            content.setCategoryIdentifier(&NSString::from_str(category));
        }
        if let Some(group) = &request.group {
            content.setThreadIdentifier(&NSString::from_str(group));
        }
        if let Some(context) = &request.context {
            let json = serde_json::to_string(context).map_err(|e| e.to_string())?;
            let info = NSDictionary::from_slices::<NSString>(
                &[&*NSString::from_str(CONTEXT_KEY)],
                &[&*NSString::from_str(&json)],
            );
            // SAFETY: a dictionary of strings is a valid property list, which
            // is the one thing `userInfo` requires; the cast only widens the
            // element types to the untyped dictionary the setter is declared on
            unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        }

        let un_request = UNRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |error: *mut NSError| {
            let outcome = if error.is_null() {
                None
            } else {
                Some(describe(error))
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(outcome);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&un_request, Some(&handler));

        Ok((id, rx))
    }

    fn parse_response(response: &UNNotificationResponse) -> NotificationResponse {
        let action = response.actionIdentifier();
        // SAFETY: reading statics the framework defines
        let (default_id, dismiss_id) = unsafe {
            (
                UNNotificationDefaultActionIdentifier,
                UNNotificationDismissActionIdentifier,
            )
        };
        let action_id = if &*action == default_id {
            DEFAULT_ACTION.to_string()
        } else if &*action == dismiss_id {
            DISMISS_ACTION.to_string()
        } else {
            action.to_string()
        };

        let request = response.notification().request();
        let notification_id = request.identifier().to_string();
        let context = context_from(&request.content().userInfo());
        NotificationResponse {
            action_id,
            notification_id,
            context,
        }
    }

    fn context_from(info: &NSDictionary) -> Option<serde_json::Value> {
        let key = NSString::from_str(CONTEXT_KEY);
        let key: &AnyObject = &key;
        let value = info.objectForKey(key)?;
        let text = value.downcast_ref::<NSString>()?.to_string();
        serde_json::from_str(&text).ok()
    }

    fn describe(error: *mut NSError) -> String {
        // SAFETY: the centre hands a live NSError for the duration of the block
        unsafe { &*error }.localizedDescription().to_string()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{NotificationCategory, NotificationRequest, UNAVAILABLE};
    use tauri::AppHandle;

    pub fn available() -> bool {
        false
    }

    pub fn install(_app: AppHandle) {}

    pub async fn request_permission() -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn register_categories(_categories: Vec<NotificationCategory>) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub async fn show(_request: NotificationRequest) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend speaks camelCase; a renamed field would silently drop
    /// the context from every press.
    #[test]
    fn request_and_response_use_camel_case_on_the_wire() {
        let request: NotificationRequest = serde_json::from_str(
            r#"{"title":"T","body":"B","categoryId":"email","context":{"threadId":"t1"},"group":"t1"}"#,
        )
        .unwrap();
        assert_eq!(request.category_id.as_deref(), Some("email"));
        assert_eq!(request.group.as_deref(), Some("t1"));
        assert_eq!(request.context.unwrap()["threadId"], "t1");

        let response = NotificationResponse {
            action_id: DEFAULT_ACTION.into(),
            notification_id: "snd-1-0".into(),
            context: Some(serde_json::json!({ "code": "123456" })),
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["actionId"], "default");
        assert_eq!(json["notificationId"], "snd-1-0");
        assert_eq!(json["context"]["code"], "123456");
    }

    #[test]
    fn optional_request_fields_default_to_none() {
        let request: NotificationRequest =
            serde_json::from_str(r#"{"title":"T","body":"B"}"#).unwrap();
        assert_eq!(request.category_id, None);
        assert_eq!(request.context, None);
        assert_eq!(request.group, None);

        let action: NotificationAction =
            serde_json::from_str(r#"{"id":"archive","title":"Archive"}"#).unwrap();
        assert!(!action.foreground);
        assert!(!action.destructive);
    }

    /// A click that launches snd reaches the delegate long before the
    /// webview listens; it must wait there rather than vanish. One test,
    /// because the inbox is process-wide state and `ready` is one-way.
    #[test]
    fn presses_before_the_webview_listens_are_kept_until_it_does() {
        let press = |id: &str| NotificationResponse {
            action_id: "reply".into(),
            notification_id: id.into(),
            context: None,
        };

        assert_eq!(inbox::accept(press("early")), None, "not listening yet: kept");

        let drained = inbox::ready();
        assert_eq!(drained, vec![press("early")]);
        assert!(inbox::ready().is_empty(), "drained once");

        assert_eq!(
            inbox::accept(press("late")),
            Some(press("late")),
            "listening now: handed straight on"
        );
    }
}
