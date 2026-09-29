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

  // Rooms live in memory, so the game must run as a single replica.
  const game = service("game", {
    source: github("praneethposina/Auction_Game", { branch: "main", checkSuites: false }),
    build: "npm run build",
    start: "npm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
    env: { APP_SECRET: preserve(), DATABASE_URL: preserve() },
  });

  return project("company-auction", {
    resources: [game, Postgres, postgresVolume],
  });
});
