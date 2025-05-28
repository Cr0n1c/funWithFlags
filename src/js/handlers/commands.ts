const AVAILABLE_COMMANDS: string[] = [
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

export function getAutocompleteSuggestions(inputText: string | undefined): string[] {
  if (!inputText?.trim()) return [];
  
  return AVAILABLE_COMMANDS.filter(command => 
    command.startsWith(inputText.toLowerCase().trim())
  );
} 