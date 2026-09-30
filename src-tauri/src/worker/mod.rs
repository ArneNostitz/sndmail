//! Headless background worker process.

mod api;
mod lifecycle;
mod login;
mod mail;
mod profiles;

pub use lifecycle::run;
pub use login::{install, uninstall};

pub(crate) use lifecycle::WorkerContext;
