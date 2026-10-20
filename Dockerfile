FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
COPY assets ./assets
COPY yardbell.example.yml ./
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client iputils-ping ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*
ARG UID=1000
ARG GID=1000
RUN groupadd -g "$GID" yardbell && useradd -m -u "$UID" -g "$GID" -s /bin/bash yardbell \
 && mkdir -p /config && chown yardbell:yardbell /config
COPY --from=build /src/target/release/yardbell /usr/local/bin/yardbell
USER yardbell
ENV HOME=/home/yardbell \
    YARDBELL_CONFIG=/config/yardbell.yml \
    YARDBELL_STATE=/config/state
VOLUME ["/config"]
ENTRYPOINT ["/usr/local/bin/yardbell"]
CMD ["serve", "--no-open"]
