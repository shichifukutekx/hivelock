# The database image, with pgBackRest for continuous backup. Postgres runs exactly as it does without this.
FROM pgvector/pgvector:pg18
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest openssl ca-certificates && rm -rf /var/lib/apt/lists/*
