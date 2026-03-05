# Snek — Realtime Snake Arena

Grid-based multiplayer snake: eat pellets to grow, avoid other snakes. Built with SpacetimeDB (server-authoritative) and Phaser.

## Development

From the project root, run:

```bash
spacetime dev
```

This starts the local SpacetimeDB server, publishes the module, and runs the Vite UI. For local dev, set `VITE_SPACETIMEDB_DB_NAME` in `.env` or `.env.local` to match the database name used by `spacetime dev` (e.g. the `database` value in `spacetime.json`).

## Controls

Arrow keys or WASD to change direction.

## Local development

Change the VITE_SPACETIMEDB_HOST=ws://localhost:3000

and do `spacetime start --in-memory`