const AVAILABLE_COMMANDS = [
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
export function getAutocompleteSuggestions(inputText) {
    if (!inputText?.trim())
        return [];
    return AVAILABLE_COMMANDS.filter(command => command.startsWith(inputText.toLowerCase().trim()));
}
//# sourceMappingURL=commands.js.map