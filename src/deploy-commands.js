const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');

const validation = validateConfig();
if (!validation.valid) {
  logger.error(validation.message);
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

function loadCommands(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      loadCommands(fullPath);
    } else if (file.endsWith('.js')) {
      const command = require(fullPath);
      if (command.data && command.execute) {
        commands.push(command.data.toJSON());
        logger.info(`Loaded command definition: /${command.data.name}`);
      } else {
        logger.warn(`File ${fullPath} is missing "data" or "execute" export.`);
      }
    }
  }
}

loadCommands(commandsPath);

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    logger.info(`Started refreshing ${commands.length} application (/) commands...`);

    if (config.guildId) {
      // Guild-specific registration (instant updates for testing)
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands }
      );
      logger.success(`Successfully registered ${commands.length} slash commands to Guild ID: ${config.guildId}!`);
    } else {
      // Global registration
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commands }
      );
      logger.success(`Successfully registered ${commands.length} global slash commands!`);
    }
  } catch (error) {
    logger.error('Failed to register slash commands:', error);
    process.exit(1);
  }
})();
