module.exports = {
  apps: [
    {
      name: "toy-api",
      script: "/app/server.js",
      env: {
        APP_NAME: "toy-p",
        PORT: "3000",
        DATABASE_URL: "postgres://toy:toy@db.internal:5432/toy",
      },
    },
  ],
};
