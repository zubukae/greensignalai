# Phase 2 operations

Phase 2 adds coordinator-managed response tasks, worker assignments and updates,
volunteer availability, scoped shelter verification and occupancy history,
private in-app notifications, per-user alert subscriptions, incident evidence,
and an operational audit trail. API permissions and geographic scope are
enforced on the server; dashboard visibility is not an authorization boundary.

## Database update

The Prisma schema adds these PostgreSQL tables:

- `volunteer_profiles`
- `response_tasks`
- `response_task_assignees`
- `response_task_updates`
- `user_notifications`
- `alert_subscriptions`
- `incident_attachments`
- `shelter_occupancy_updates`
- `operational_audits`

It also adds shelter verification fields and an optional alert hazard type.
Existing PostgreSQL deployments must apply the schema before using these
endpoints, for example with the project's `npm run db:push` after reviewing and
backing up the target database. No database migration was run as part of this
change.

## External services and storage

- Alerts from the Bangladesh Meteorological Department (BMD), Flood Forecasting
  and Warning Centre (FFWC), and Department of Disaster Management (DDM) are
  not connected. Alerts created in the app are staff-entered broadcasts and
  must not be treated as official warnings.
- SMS, email, and mobile push delivery are not configured. Notifications are
  persisted and available only inside the application.
- Incident evidence (JPEG, PNG, WebP, or PDF; maximum 5 MB per file) is stored
  as PostgreSQL binary data and served only to authenticated responders in the
  incident's authorized area. No external object-storage service or independent
  at-rest encryption key management is configured.
- Shelter verification and occupancy are operational records entered by
  authorized coordinators; no verified shelter registry or live occupancy feed
  is integrated.

The application's in-memory fallback supports these operations and provides
rollback for failed callback transactions, but it is not durable storage.
