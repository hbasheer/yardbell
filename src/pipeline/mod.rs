pub mod engine;
pub mod linear;
pub mod prompts;
pub mod record;
pub mod store;

use record::{Record, Ticket};
use std::path::PathBuf;
use store::Store;

pub struct Pipeline {
    store: Store,
}

impl Pipeline {
    pub fn new(file: PathBuf) -> Pipeline {
        Pipeline {
            store: Store::load(file),
        }
    }

    pub fn add(&self, tickets: &[Ticket], started_by: &str) -> Result<Vec<Record>, String> {
        let now = chrono::Local::now();
        let run = format!("r{}", now.format("%Y%m%d-%H%M"));
        self.store.add(tickets, &run, started_by, &now.to_rfc3339())
    }

    pub fn records(&self) -> Vec<Record> {
        self.store.all()
    }
}
