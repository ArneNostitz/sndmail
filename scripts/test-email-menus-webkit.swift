// macOS browser regression test. Start npm run dev, then:
// swift scripts/test-email-menus-webkit.swift
// Exercises real React components and CSP in WKWebView; no user mail is loaded.
import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 650))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
window.orderFront(nil)
let baseURL = CommandLine.arguments.dropFirst().first ?? "http://localhost:1420"
web.load(URLRequest(url: URL(string: baseURL + "/scripts/fixtures/email-menus.html")!))

func js(_ source: String) async throws -> Any? {
    try await web.evaluateJavaScript(source)
}
func check(_ source: String, _ description: String) async throws {
    guard let result = try await js(source) as? Bool, result else {
        throw NSError(domain: "EmailMenus", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }
    print("PASS:", description)
}
Task { @MainActor in
    do {
        for _ in 0..<100 {
            if (try? await js("!!document.querySelector('iframe')?.contentDocument?.querySelector('p')")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try await check("!!document.querySelector('iframe')?.contentDocument?.querySelector('p')", "real EmailRenderer mounted")
        _ = try await js("""
          window.mail = document.querySelector('iframe'); window.doc = mail.contentDocument;
          const r = doc.createRange(); r.selectNodeContents(doc.querySelector('p'));
          doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r);
        """)
        try await Task.sleep(nanoseconds: 200_000_000)
        try await check("!!document.querySelector('[aria-label=\"Create task from selected text\"]')", "native selectionchange displays the task strip")
        try await check("""
          (() => { const e = new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:80,clientY:30});
          doc.querySelector('p').dispatchEvent(e); return e.defaultPrevented; })()
        """, "selected-text right-click cancels the native menu")
        try await Task.sleep(nanoseconds: 100_000_000)
        try await check("['Copy','Make task','Make AI task'].every(label => [...document.querySelectorAll('[role=menuitem]')].some(e => e.textContent === label))", "selected-text app menu exposes copy and both task actions")
        _ = try await js("""
          doc.getSelection().removeAllRanges();
          doc.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
        """)
        try await Task.sleep(nanoseconds: 100_000_000)
        try await check("fixtureMenuStore.getState().menuType === null", "clicking email body dismisses the previous menu")
        try await check("""
          (() => { const e = new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:40,clientY:30});
          doc.querySelector('p').dispatchEvent(e); return e.defaultPrevented; })()
        """, "unselected email body uses the app message menu")
        try await Task.sleep(nanoseconds: 100_000_000)
        try await check("fixtureMenuStore.getState().menuType === 'message'", "body right-click reaches message actions")
        _ = try await js("fixtureShortcutStore.setState({keyMap:{'action.reply':'Ctrl+Shift+R','action.archive':'Alt+A'}})")
        try await Task.sleep(nanoseconds: 100_000_000)
        try await check("(() => { const replies = [...document.querySelectorAll('[role=menuitem]')].filter(e=>e.querySelector('span.flex-1')?.textContent === 'Reply'); return replies.length === 2 && replies.every(e=>e.textContent.includes('Ctrl+Shift+R')); })()", "list and message menus use current Settings shortcuts")
        try await check("getComputedStyle(document.querySelector('[role=menu]')).backgroundColor === 'rgb(255, 255, 255)'", "menu surface is opaque white")
        // Bypass the sanitizer deliberately to test the second line of defense.
        _ = try await js("""
          window.emailScriptRan = false;
          const script = doc.createElement('script'); script.textContent = 'parent.emailScriptRan = true'; doc.body.append(script);
          const external = doc.createElement('script'); external.src = 'data:text/javascript,parent.emailScriptRan=true'; doc.body.append(external);
          const img = doc.createElement('img'); img.setAttribute('onerror','parent.emailScriptRan = true'); img.src = '/missing-fixture-image'; doc.body.append(img);
          const link = doc.createElement('a'); link.href = 'javascript:parent.emailScriptRan=true'; doc.body.append(link); link.click();
        """)
        try await Task.sleep(nanoseconds: 300_000_000)
        try await check("window.emailScriptRan === false", "CSP blocks inline/external email scripts, event attributes, and javascript URLs")
        _ = try await js("doc.querySelectorAll('script, img, a').forEach(e=>e.remove()); fixtureMenuStore.getState().closeMenu(); const r2 = doc.createRange(); r2.selectNodeContents(doc.querySelector('p')); doc.getSelection().addRange(r2);")
        try await Task.sleep(nanoseconds: 200_000_000)
        let image = try await web.takeSnapshot(configuration: nil)
        if let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: "/private/tmp/sndmail-email-menus-webkit.png"))
        }
        print("WebKit regression checks passed. Screenshot: /private/tmp/sndmail-email-menus-webkit.png")
        exit(0)
    } catch {
        print("FAIL:", error)
        exit(1)
    }
}
app.run()
