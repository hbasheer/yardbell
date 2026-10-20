#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yardbell=info".into()),
        )
        .init();
    if let Err(e) = yardbell::cli::run().await {
        eprintln!("yardbell: {e:#}");
        std::process::exit(1);
    }
}
