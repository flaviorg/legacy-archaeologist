// Results that depend on the time zone (GEN-01): recorded under TZ=UTC, the emitted tests must agree in any TZ.
function dayOf(date) {
  return date.getDate();
}

function hourOf(date) {
  return date.getHours();
}

module.exports = { dayOf: dayOf, hourOf: hourOf };
