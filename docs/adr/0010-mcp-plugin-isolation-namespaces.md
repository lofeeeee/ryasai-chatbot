# ADR 0010: MCP Plugin Isolation via Namespaces

**Status:** Accepted  
**Date:** 2026-10-02

## Context

A plugin's `mcp-stdio` manifest names a command, and the application spawns it as a child of the
app process. The interpreter allowlist (`ALLOWED_MCP_CMDS`) restricts *which* interpreter may run —
but an interpreter is Turing-complete, so an allowlisted `node` can still open sockets, read any
file the app user can read, and enumerate and signal other processes. Allowlisting the interpreter
is a naming check, not a containment boundary.

The deployment shape constrains the options:

- Installs run on a single on-prem host — 1 vCPU / 1GB in the minimum case, an Ubuntu/Debian VPS.
- The installer must work with no container-runtime requirement beyond Docker Engine.
- No install currently has a plugin marketplace. The plugin list is first-party plus
  operator-installed, so the author of every running plugin is known to the operator.

Two candidate mechanisms existed. Linux namespaces via `unshare` need no new dependency and no new
runtime; a rootless-container or bubblewrap tier would additionally need a runtime present and
configured on every host, plus a filesystem image per plugin. The measured behaviour on the target
host: `unshare --user --map-root-user --mount --pid --fork --net node -e ...` runs as the non-root
app user, and inside it `os.networkInterfaces()` reports zero non-loopback interfaces. That is real
isolation of the network, PID and mount views without a container runtime.

A detail that shaped the implementation: composition order matters. `unshare` must wrap the *shell*
that applies `ulimit`, so the limits are set inside the namespace rather than on the wrapper — the
reverse order applies the caps to `unshare` itself and bounds nothing.

## Decision

Wrap every plugin-spawned MCP server in `unshare` (`src/lib/plugin-sandbox.ts`):

- a **network namespace** — the plugin gets no route off the box;
- a **PID namespace** — it cannot see or signal other processes;
- a **mount namespace** — its mounts do not leak into the host;
- a **user namespace** (`--map-root-user`) — which is what makes the others available to a
  non-root process.

Resource limits via `ulimit` cap file size (256 MB), open file descriptors (1024) and process count
(512), applied inside the namespace so they bound the plugin rather than the wrapper. A kernel that
refuses the exact namespace combination (e.g. `kernel.unprivileged_userns_clone` disabled) degrades
to rlimits-only, and the isolation level actually obtained is reported in logs and the admin UI
rather than assumed — the probe runs the exact flag combination that will be used, because a host
can permit user namespaces yet forbid network namespaces in container configurations.

**This is resource isolation, not a security sandbox**, and it is documented as such where the code
lives rather than in this ADR alone:

- it is **not a filesystem sandbox** — the mount namespace is not populated with a read-only root,
  so the process reads whatever the app user can read, including configuration;
- there is **no seccomp filter** — the syscall surface is unrestricted;
- there are **no cgroup CPU or memory caps** — a busy plugin can still starve the host.

It is containment against a buggy or careless plugin, not against a determined one.

A rootless-container / bubblewrap tier is **deferred** until a real deployment requires third-party
plugins from untrusted authors. Building it before that requirement exists would mean shipping and
maintaining an isolation story that no install exercises.

## Consequences

- **Positive:** a plugin cannot reach the network, inspect or signal other processes, or exhaust
  disk, descriptors or process count — with no new dependency and no container-runtime
  requirement, so it works on the minimal host the installer targets.
- **Positive:** the level obtained is reported rather than assumed, so an operator on a locked-down
  kernel sees "resource limits only" in logs and the admin UI instead of believing namespaces are
  active.
- **Positive:** a host with no `unshare` binary at all still runs the plugin, degraded to rlimits,
  rather than failing the install — the probe failure path is a defined level, not an exception.
- **Negative: a plugin can still read every file the app user can read.** Only first-party and
  operator-installed plugins are trusted today; the trust boundary is the operator who installs the
  manifest, not the sandbox.
- **Negative: CPU and memory are uncapped**, so a CPU-bound plugin competes with the app and the
  app's LLM calls for the host. `ulimit -u` bounds a fork bomb's growth rate, not compute.
- **Negative: `--map-root-user` maps the app user to uid 0 *inside* the namespace.** That is what
  makes the other namespaces available unprivileged, and it grants nothing on the host — but it
  means a plugin's own permission checks ("am I root?") answer yes, which can change plugin
  behaviour in ways the plugin author did not test for.
- **Operational rule that follows:** the compose file must not enable arbitrary plugin installs in
  multi-tenant deployments. While the filesystem stays readable, sandboxing cannot substitute for
  vetting the plugin list.

## Alternatives

- **Rootless container / bubblewrap now:** deferred — the right tool for untrusted authors, but it
  adds a runtime requirement every install must satisfy for a threat (third-party plugin
  marketplaces) no current deployment has.
- **Interpreter allowlist alone:** rejected — it checks a name, not behaviour, and was the
  pre-existing state this decision replaces.
- **No isolation:** rejected — a plugin bug would be indistinguishable from an app bug, with the
  network reachable and no bound on resource use.
- **Seccomp + cgroups via a supervisor:** rejected for now — a second supervisor process per plugin
  is a new component and a new failure mode on a 1GB host, for the same "careless plugin" threat
  the namespaces already cover.
- **A Docker container per plugin:** rejected — the app would need to hold the Docker socket to
  spawn them, which is a larger privilege grant than the isolation it buys.
