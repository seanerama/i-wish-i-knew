# TODO(stage-2): placeholder image so the `image` gate in .verity/gates.json
# can run before the service exists. Stage 2 replaces this with the
# multi-stage node:22-alpine service image described in docs/walking-skeleton.md.
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN node --version
CMD ["node", "--version"]
