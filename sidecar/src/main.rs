mod cli;
mod fx_dsh;
mod indexer;
mod scan;
mod types;
mod token_accounting;

#[cfg(test)]
mod fx_dsh_tests;
#[cfg(test)]
mod indexer_tests;
#[cfg(test)]
mod scan_tests;

fn main() {
    cli::run();
}
