import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// Railway infrastructure for the Company Auction game (replaces railway.json).
// Preview changes with `railway config plan`, apply with `railway config apply`.
export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });

  // Rooms live in memory, so the game must run as a single replica. On a deploy the old
  // process gets SIGTERM once the new one is healthy; it then has `drainingSeconds` to save
  // running games to Postgres for the new process to pick up (see server/keeper.ts).
  const game = service("game", {
    source: github("praneethposina/Auction_Game", { branch: "main", checkSuites: false }),
    build: "npm run build",
    // node directly (not npm/tsx wrappers) so SIGTERM reaches the server.
    start: "node --import tsx server/index.ts",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
    deploy: { drainingSeconds: 20, overlapSeconds: 0 },
    env: { APP_SECRET: preserve(), DATABASE_URL: preserve() },
  });

  return project("company-auction", {
    resources: [game, Postgres, postgresVolume],
  });
});
