# Build only from a verified, minimal server-release context (see
# docs/container.md). The repository itself is not an image build context.
FROM scratch

ARG VERSION
ARG REVISION
ARG CREATED
LABEL org.opencontainers.image.title="Agent Mesh" \
      org.opencontainers.image.description="Self-hosted Agent Mesh coordination server" \
      org.opencontainers.image.source="https://github.com/Vlad9572324/agent-mesh" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

COPY --chmod=0555 bin/agent-mesh /opt/agent-mesh/bin/agent-mesh
COPY --chmod=0444 web/index.html web/app.js web/app.css /opt/agent-mesh/web/
COPY --chmod=0444 RELEASE.json INSTALL.md LICENSE NOTICE THIRD_PARTY_NOTICES.md /opt/agent-mesh/

USER 10001:10001
WORKDIR /opt/agent-mesh
EXPOSE 8766
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/agent-mesh/bin/agent-mesh"]
# Inspecting an image never creates a database, starts a server, or seeds users.
CMD ["version"]
