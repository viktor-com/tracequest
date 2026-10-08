import { mock } from "node:test";

export function mockHttpResponse({ mockFns = false } = {}) {
  let status;
  let headers;
  let body;
  const writeHead = (s, h) => {
    status = s;
    headers = h;
    res.headersSent = true;
  };
  const end = (b) => {
    body = b;
  };
  const res = {
    headersSent: false,
    writeHead: mockFns ? mock.fn(writeHead) : writeHead,
    end: mockFns ? mock.fn(end) : end,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  };
  return res;
}

export function captureJsonHandler() {
  let body = "";
  const responseHeaders = {};
  const res = {
    writeHead: mock.fn((_status, h) => {
      Object.assign(responseHeaders, h);
    }),
    end: mock.fn((b) => {
      body = b;
    }),
  };
  return {
    res,
    parse: () => JSON.parse(body),
    get headers() {
      return responseHeaders;
    },
  };
}