import { createConnection } from "node:net";

/** Whether something accepts TCP connections on the port. */
export async function isPortOpen(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return await new Promise<boolean>((accept) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      accept(true);
    });
    const closed = () => {
      socket.destroy();
      accept(false);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}
