mod cli;
mod indexer;
mod scan;
mod types;
mod token_accounting;

#[cfg(test)]
mod indexer_tests;
#[cfg(test)]
mod scan_tests;

fn main() {
    cli::run();
}
