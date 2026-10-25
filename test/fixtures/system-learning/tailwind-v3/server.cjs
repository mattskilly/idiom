const http = require("node:http");
const fs = require("node:fs");
http
  .createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(fs.readFileSync(`${__dirname}/index.html`));
  })
  .listen(Number(process.env.PORT || 3000), "127.0.0.1");
