import { hostedApi } from "../src/hosted/api.js";

export default {
  fetch(request: Request) {
    return hostedApi(request, "report");
  },
};
