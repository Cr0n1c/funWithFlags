
function getAutocompleteSuggestions(inputText) {
  const availableCommands = [
    "about",
    "challenges",
    "clear",
    "date",
    "help",
    "leaderboard",
    "login",
    "logout",
    "submit"
  ];

  const inputText = terminalInput.innerText.trim();

  return availableCommands.filter((command) => {
    return command.startsWith(inputText.toLowerCase());
  });
}
