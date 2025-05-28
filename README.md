# Retro Terminal

A throwback retro CRT-style terminal application with a beautiful, nostalgic interface. This application provides an interactive terminal experience with classic CRT monitor effects, including scanlines, screen flicker, and phosphor color options.

**Demo:** [Link](https://cr0n1c.github.io/funWithFlags/)

![Retro Terminal](docs/screenshot.png)

## Features

- 🖥️ Authentic CRT monitor effects
- 🎨 Switchable phosphor colors (Amber/Green)
- 🔊 Retro sound effects (power on/off, keypress)
- ⌨️ Interactive terminal with command history
- 📺 Fullscreen mode support
- 💾 Command auto-completion
- 🎮 Responsive design for all screen sizes

## Available Commands

- `help` - Display a list of available commands
- `date` - Show the current date and time
- `clear` - Clear the terminal output
- `about` - Learn more about the application

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Cr0n1c/funWithFlags.git
   cd funWithFlags
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

To run the application in development mode:

```bash
npm run start:dev
```

This will:
- Start a development server on port 8888
- Watch for changes in the source files
- Automatically rebuild when changes are detected

## Production Build

To create a production build:

```bash
npm run build:prod
```

This will:
- Clean the previous build
- Copy and process source files
- Compile SASS to CSS
- Minify HTML
- Generate optimized assets in the `dist` directory

To run the production build locally:

```bash
npm run start:prod
```

This will start a server on port 8080.

## Deployment

The application is configured for deployment to GitHub Pages. To deploy:

```bash
npm run deploy
```

This will:
1. Create a production build
2. Copy the build to a release directory
3. Deploy to GitHub Pages
4. Clean up temporary files

## Project Structure

```
funWithFlags/
├── src/
│   ├── fonts/        # Custom web fonts
│   ├── images/       # Images and assets
│   ├── js/           # JavaScript source files
│   ├── sass/         # SASS stylesheets
│   └── index.html    # Main HTML file
├── dist/             # Production build output
├── release/          # Temporary deployment directory
├── docs/             # Houses artifacts for README.md
└── package.json      # Project configuration
```

## Customization

### Changing Theme Colors

The application supports two phosphor colors:
- Amber (default)
- Green

You can toggle between them using the theme button in the top-right corner.

### Sound Effects

Sound effects can be customized by replacing the audio files in the `src/sounds` directory:
- `power_on.mp3` - Played when terminal starts
- `power_off.mp3` - Played when terminal shuts down
- `keypress.mp3` - Played when typing

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Authors

- Brandon Helms
- George Merlocco <george@merloc.co>

## Acknowledgments

- Inspired by classic CRT monitors and retro computing
- Built with modern web technologies while maintaining a vintage aesthetic
