import { createServer } from "./app.mjs";

// FC custom runtimes expose the configured CA port through FC_CUSTOM_LISTEN_PORT.
// Keep PORT as a local override and retain 3000 for local development.
const port = Number(process.env.FC_CUSTOM_LISTEN_PORT ?? process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const server = await createServer();
server.listen(port, host, () => console.log(`Data Platform Demo is running at http://${host}:${port}`));
