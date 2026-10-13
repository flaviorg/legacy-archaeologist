// A threshold a reader could easily misread (SUS-01): 50 itself gets no discount.
function discount(total) {
  if (total > 50) {
    return total * 0.9;
  }
  return total;
}

module.exports = { discount: discount };
