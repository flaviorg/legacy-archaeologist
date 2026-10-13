// One function per side-effect kind; the line of each effect is asserted by side-effects.unit.
var f = require("fs");
var cp = require("child_process");
var net = require("node:net");
var http = require("https");
var dns = require("dns");
var crypto = require("crypto");
var counter = 0;

function useDate() { return Date.now(); }
function useRandom() { return Math.random(); }
function usePerformance() { return performance.now(); }
function useHrtime() { return process.hrtime(); }
function useCrypto() { return crypto.randomUUID(); }
function useFs() { f.writeFileSync("x.txt", "x"); }
function useChildProcess() { return cp.execSync("ls"); }
function useNet() { return net.connect(80); }
function useHttp() { return http.get("https://example.invalid"); }
function useDns() { dns.lookup("example.invalid", function () {}); }
function useConsole() { console.log("hi"); }
function useEnv() { return process.env.HOME; }
function useTimers() { setTimeout(function () {}, 10); }
function useIntl() { return new Intl.NumberFormat("en-US").format(1); }
function writeGlobal() { global.LAST = 1; }
function writeModule() { counter = counter + 1; }

module.exports = {
  useDate: useDate, useRandom: useRandom, usePerformance: usePerformance, useHrtime: useHrtime,
  useCrypto: useCrypto, useFs: useFs, useChildProcess: useChildProcess, useNet: useNet,
  useHttp: useHttp, useDns: useDns, useConsole: useConsole, useEnv: useEnv,
  useTimers: useTimers, useIntl: useIntl, writeGlobal: writeGlobal, writeModule: writeModule
};
