# Database schema

Entity-relationship diagram of the Supabase (PostgreSQL) public tables.

![Database schema](database-schema.drawio.png)

## Legend

- **Solid lines** — foreign key constraints
- **Dashed lines** — conventions without an FK (e.g. `users.id` mirrors `auth.users.id`; high-churn price/event tables reference `assets.symbol` without a constraint so purges stay cheap)
- **Colors** — users/notifications (blue), watchlist/alerts (yellow), assets (green), prediction markets (orange), auth (purple), standalone ops tables (grey)

## Editing

The PNG embeds the draw.io source — open `database-schema.drawio.png` in [draw.io](https://app.diagrams.net/) to edit, then re-export with the diagram embedded (`-e` / “Include a copy of my diagram”).

Regenerate after schema changes. The generated FK map lives in `src/lib/db/generated/database.types.ts` (`Relationships` on each table).
