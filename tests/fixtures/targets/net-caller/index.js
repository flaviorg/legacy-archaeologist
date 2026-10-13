// Network calls the guard blocks (SAFE-03).
var http = require("http");
var dns = require("dns");
var net = require("net");

function doFetch() {
  return fetch("https://example.com/");
}

function httpRequest() {
  return http.request("http://example.com/").end();
}

function dnsLookup() {
  dns.lookup("example.com", function () {});
  return "looked up";
}

function loopbackSocket() {
  net.connect(9, "127.0.0.1");
  return "connected";
}

module.exports = { doFetch: doFetch, httpRequest: httpRequest, dnsLookup: dnsLookup, loopbackSocket: loopbackSocket };
