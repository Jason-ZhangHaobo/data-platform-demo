import { createServer } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const server = await createServer();
server.listen(port, host, () => console.log(`Data Platform Demo is running at http://${host}:${port}`));
