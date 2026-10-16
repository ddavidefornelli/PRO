pub mod application;
pub mod domain;
pub mod infrastructure;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "desktop")]
pub use desktop::run;
