# @semanaut/zpi-peer

Equal, durable peers in tmux windows plus a letter channel between any pi sessions, for [pi](https://github.com/earendil-works/pi).

A session is alive exactly while a live pane carries its `@pi_sid` label. Peers can be spawned, listed, mailed, and revived.

## Install

```bash
pi install npm:@semanaut/zpi-peer
```

## Requires

tmux.

## Bundled skill

Installs the `peer-orchestrator` skill (policy for spawning and steering equal pi peers) alongside the extension.
