// Function to roll the dice based on the number of sides and dice type identifier
function rollDice(sides, diceType) {
  // Retrieve the number of dice from the corresponding input field
  let countInput = document.getElementById(`${diceType}-count`);
  let count = parseInt(countInput.value) || 1;
  
  let results = [];
  for (let i = 0; i < count; i++) {
    // Generate a random number between 1 and the number of sides (inclusive)
    let roll = Math.floor(Math.random() * sides) + 1;
    results.push(roll);
  }
  
  displayResults(diceType, results);
}

// Function to display the results on the page
function displayResults(diceType, results) {
  const display = document.getElementById('results-display');
  let resultHTML = `<p><strong>${diceType}:</strong> ${results.join(', ')}</p>`;
  display.innerHTML += resultHTML;
}

// Function to reset/clear the displayed results
function resetResults() {
  const display = document.getElementById('results-display');
  display.innerHTML = '';
}
