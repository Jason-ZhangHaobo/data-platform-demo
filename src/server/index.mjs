import { createServer } from "./app.mjs";

// FC custom runtimes route requests to CA port 9000 by default. Local scripts
// explicitly set PORT=3000, while FC can still override the port when provided.
const port = Number(process.env.FC_CUSTOM_LISTEN_PORT ?? process.env.PORT ?? 9000);
const host = process.env.HOST ?? "0.0.0.0";
const server = await createServer();
server.listen(port, host, () => console.log(`Data Platform Demo is running at http://${host}:${port}`));
