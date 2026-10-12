# GreenSignalAI

GreenSignalAI is a disaster preparedness and response coordination platform
focused on Bangladesh. It combines a web dashboard with an Express and
Socket.IO backend, a PostgreSQL data model managed by Prisma, and an in-memory
fallback for local demonstrations.

> **Important:** GreenSignalAI is not an official warning service. Its alerts
> may be demonstration or staff-entered information. Check official Bangladesh
> Meteorological Department (BMD), Department of Disaster Management (DDM), and
> Flood Forecasting and Warning Centre (FFWC) sources for warnings and
> instructions.

## Features

- **Incident reporting and review:** Citizens can submit incident reports and
  check report status with a private access key. Authorized responders can
  review reports, update their status, and see the area-scoped incident queue.
- **Responder messaging:** Authenticated users can coordinate through direct
  and group messaging. Message encryption keys are managed by the clients;
  recovery information must be saved by the user.
- **Response tasks:** Coordinators can create tasks and assign workers.
  Responders see their assignments, update progress, and add completion notes.
- **Volunteer profiles:** Users can record skills and availability. Authorized
  coordinators can view volunteer information within their area.
- **Shelter operations:** Coordinators can verify shelter records and update
  occupancy. Changes are recorded in history.
- **Notifications and alerts:** The app stores private in-app notifications,
  supports per-area alert subscriptions, and allows authorized coordinators
  and administrators to broadcast alerts within their permitted scope.
- **Incident evidence and audit history:** Responders can attach and retrieve
  scoped JPEG, PNG, WebP, and PDF evidence (maximum 5 MB per file).
  Operational changes are recorded in an audit trail.
- **Bangladesh administrative geography:** The Prisma model supports
  country/division/district/upazila hierarchy, localized hazard reports, and
  shelter, sensor, and operational records.

The incident-reporting form includes an English/Bangla language option. The
rest of the interface is currently primarily English.

## Technology

- Node.js 18 or later and TypeScript
- Express 4 and Socket.IO 4
- PostgreSQL and Prisma 5
- Static HTML/JavaScript dashboard in `public/`

## Local setup

1. Install Node.js 18 or later and make PostgreSQL available.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Create a local `.env` file based on `.env.example` and configure both
   variables:

   ```dotenv
   DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public"
   JWT_SECRET="replace-with-a-long-random-secret"
   ```

   Use a unique, high-entropy `JWT_SECRET` in every deployed environment. The
   server refuses to start in production without it. Do not commit `.env` or
   real credentials.

4. Apply the Prisma schema to your development database:

   ```sh
   npx prisma validate
   npm run db:push
   ```

   Back up the database and review schema changes before applying them to an
   existing or production database. `db:push` changes the target schema; it is
   not a substitute for a reviewed production migration process.

5. Start the development server:

   ```sh
   npm run dev
   ```

   The server listens on port `3000`. Open `http://localhost:3000`.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the TypeScript development server with `tsx`. |
| `npm run build` | Generate the Prisma client and compile TypeScript into `dist/`. |
| `npm run lint` | Run the TypeScript compiler in no-output mode. |
| `npm test` | Run the Node.js test suite through `tsx`. |
| `npx prisma validate` | Validate `prisma/schema.prisma`. |
| `npm run db:push` | Apply the Prisma schema to the configured database. |
| `npm start` | Start the compiled application from `dist/server.js`. |

`npm run db:seed` is intended only for a disposable development database. The
seed script deletes existing simulation runs, response policies, chat messages,
alerts, sensors, relief centers, and administrative nodes before seeding. Do
not run it against a database whose data must be retained.

## Database and fallback behavior

The Prisma schema is in `prisma/schema.prisma`. It includes Bangladesh
administrative nodes, users and roles, incidents and their timelines,
coordination groups, response tasks and assignments, volunteer profiles,
shelters, alert subscriptions, notifications, incident attachments, and
operational audit records.

If `DATABASE_URL` is not configured, the application uses a seeded in-memory
store for demonstrations. In-memory changes are temporary and disappear when
the process restarts; this mode is not suitable for production. Configure and
verify a PostgreSQL database before using the platform for persistent
operations.

The operational tables, shelter verification fields, and alert hazard field
require the current Prisma schema to be applied before using Phase 2 features.
See [Phase 2 operations](./PHASE-2-OPERATIONS.md) for the table list, evidence
storage details, and known external-service limitations.

## Security and operational notes

- Role and geographic-scope checks are performed by the backend. Dashboard
  visibility is not an authorization mechanism.
- Use HTTPS in deployed environments and protect database backups and access.
- Incident evidence is stored in PostgreSQL and downloaded only by authenticated
  responders authorized for the incident area. External object storage and
  independent at-rest encryption key management are not configured.
- In-app notifications do not currently send SMS, email, or mobile push
  messages.
- BMD, DDM, and FFWC alert feeds and a verified shelter registry are not
  integrated. App-created alerts and shelter records are not independently
  verified by those organizations.

## Repository layout

```text
prisma/       Prisma schema and seed script
public/       Static web interface and browser-side JavaScript
src/lib/      Authentication, Prisma access, and in-memory data adapter
src/routes/   Express API routes
src/services/ Incident, messaging, alert, and operations logic
tests/        Automated tests
```
