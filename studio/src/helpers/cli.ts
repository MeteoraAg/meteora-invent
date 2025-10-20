import {
  AlphaVaultConfig,
  CliArguments,
  CommandOption,
  DammV1Config,
  DammV2Config,
  DbcConfig,
  DlmmConfig,
  MeteoraConfig,
  NetworkConfig,
  PresaleConfig,
} from '../utils/types';
import { parseArgs } from 'util';
import { safeParseJsonFromFile } from './utils';
import { parse } from 'csv-parse';
import fs from 'fs';
import * as readline from 'readline';
import path from 'path';

export function parseCliArguments(): CliArguments {
  const { values } = parseArgs({
    args: process.argv,
    options: {
      network: {
        type: 'string',
      },
      baseMint: {
        type: 'string',
      },
      poolAddress: {
        type: 'string',
      },
      airdrop: {
        type: 'boolean',
      },
      help: {
        type: 'boolean',
      },
      config: {
        type: 'string',
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return values;
}

export async function getConfigFromPath(configPath: string): Promise<MeteoraConfig> {
  return await safeParseJsonFromFile(configPath);
}

export async function getDammV1Config(): Promise<DammV1Config> {
  const configPath = path.join(__dirname, '../../config/damm_v1_config.jsonc');
  const config: DammV1Config = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getDammV2Config(): Promise<DammV2Config> {
  const configPath = path.join(__dirname, '../../config/damm_v2_config.jsonc');
  const config: DammV2Config = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getDlmmConfig(): Promise<DlmmConfig> {
  const configPath = path.join(__dirname, '../../config/dlmm_config.jsonc');
  const config: DlmmConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getDbcConfig(): Promise<DbcConfig> {
  const configPath = path.join(__dirname, '../../config/dbc_config.jsonc');
  const config: DbcConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getAlphaVaultConfig(): Promise<AlphaVaultConfig> {
  const configPath = path.join(__dirname, '../../config/alpha_vault_config.jsonc');
  const config: AlphaVaultConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getPresaleConfig(): Promise<PresaleConfig> {
  const configPath = path.join(__dirname, '../../config/presale_vault_config.jsonc');
  const config: PresaleConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export function getNetworkConfig(network: string): NetworkConfig {
  switch (network.toLowerCase()) {
    case 'devnet':
      return {
        rpcUrl: 'https://api.devnet.solana.com',
        airdropAmount: 5,
      };
    case 'localnet':
      return {
        rpcUrl: 'http://localhost:8899',
        airdropAmount: 5,
      };
    default:
      throw new Error('Invalid network. Please use --network devnet or --network localnet');
  }
}

export async function parseCsv<T>(filePath: string): Promise<Array<T>> {
  const fileStream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true, // Use the header row as keys
      skip_empty_lines: true, // Skip empty lines
    });

    const results: T[] = [];

    fileStream
      .pipe(parser)
      .on('data', (row: T) => results.push(row)) // Collect rows
      .on('end', () => resolve(results)) // Resolve the promise with results
      .on('error', (err) => reject(err)); // Reject the promise if error occurs
  });
}

/**
 * Interactive CLI selection helper that displays options and returns user's choice
 * @param options - Array of display strings for each option
 * @param prompt - The question to ask the user
 * @returns Promise that resolves to the selected index (0-based)
 */
export async function promptForSelection(
  options: string[],
  prompt: string = 'Please select an option'
): Promise<number> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n${prompt}:`);
    options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option}`);
    });

    const askQuestion = () => {
      rl.question(`\nEnter your choice (1-${options.length}): `, (answer) => {
        const choice = parseInt(answer.trim(), 10);

        if (isNaN(choice) || choice < 1 || choice > options.length) {
          console.log(`Invalid choice. Please enter a number between 1 and ${options.length}.`);
          askQuestion();
          return;
        }

        rl.close();
        resolve(choice - 1); // Convert to 0-based index
      });
    };

    askQuestion();
  });
}

export function displayHelp(
  commandName: string,
  description: string,
  options: CommandOption[]
): void {
  console.log(`\n> Command: ${commandName}`);
  console.log(`${description}`);

  console.log('\n>> Usage:');
  console.log(`- pnpm studio ${commandName} [options]`);

  console.log('\n>> Options:');
  options.forEach((option) => {
    const required = option.required ? ' (required)' : ' (optional)';
    const typeInfo = option.type === 'boolean' ? '' : ` <${option.type}>`;
    const example = option.example ? ` (e.g. ${option.example})` : '';

    console.log(`--${option.flag}${typeInfo}${required}`);
    console.log(`~ ${option.description}${example}`);
    console.log();
  });
}
