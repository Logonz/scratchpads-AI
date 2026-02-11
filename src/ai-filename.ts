import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config } from './config';
import {
  CONFIG_OPENAI_API_KEY,
  CONFIG_OPENAI_MODEL,
  CONFIG_RENAME_PROVIDER,
} from './consts';

export type RenameProvider = 'auto' | 'vscode' | 'openai';

export class AIFilenameService {
  public static async suggestFilename(content: string, fileExt: string): Promise<string | undefined> {
    const provider = (Config.getExtensionConfiguration(CONFIG_RENAME_PROVIDER) as RenameProvider) || 'auto';

    if (provider === 'vscode' || provider === 'auto') {
      const vscodeSuggestion = await this.suggestWithVSCodeLM(content, fileExt);
      if (vscodeSuggestion) {
        return vscodeSuggestion;
      }
    }

    if (provider === 'openai' || provider === 'auto') {
      return await this.suggestWithOpenAI(content, fileExt);
    }

    return undefined;
  }

  private static async suggestWithVSCodeLM(content: string, fileExt: string): Promise<string | undefined> {
    try {
      const vscodeAny = vscode as unknown as {
        lm?: {
          selectChatModels: (selector: Record<string, string>) => Promise<Array<{
            sendRequest: (messages: unknown[], options: Record<string, never>, token: vscode.CancellationToken) => Promise<{ text: AsyncIterable<string> }>
          }>>;
        };
        LanguageModelChatMessage?: {
          User: (content: string) => unknown;
        };
      };

      if (!vscodeAny.lm || !vscodeAny.LanguageModelChatMessage) {
        return undefined;
      }

      const selectors: Array<Record<string, string>> = [
        { vendor: 'copilot', family: 'gpt-5-mini' },
        { vendor: 'copilot', family: 'gpt-4o-mini' },
        { vendor: 'copilot' },
      ];

      let model:
        | {
            sendRequest: (
              messages: unknown[],
              options: Record<string, never>,
              token: vscode.CancellationToken,
            ) => Promise<{ text: AsyncIterable<string> }>;
          }
        | undefined;

      for (const selector of selectors) {
        const [candidate] = await vscodeAny.lm.selectChatModels(selector);
        if (candidate) {
          model = candidate;
          break;
        }
      }

      if (!model) {
        return undefined;
      }

      const prompt = [
        vscodeAny.LanguageModelChatMessage.User(
          `Generate a short, descriptive filename based on content. Respond with filename text only, no extension, no markdown, no quotes, lowercase with dashes only. Target extension: ${fileExt || 'none'}.`,
        ),
        vscodeAny.LanguageModelChatMessage.User(content),
      ];

      const response = await model.sendRequest(prompt, {}, new vscode.CancellationTokenSource().token);
      let output = '';
      for await (const fragment of response.text) {
        output += fragment;
      }

      return this.sanitizeFilename(output);
    } catch {
      return undefined;
    }
  }

  private static async suggestWithOpenAI(content: string, fileExt: string): Promise<string | undefined> {
    const apiKey = (Config.getExtensionConfiguration(CONFIG_OPENAI_API_KEY) as string) || '';
    if (!apiKey) {
      return undefined;
    }

    const model = (Config.getExtensionConfiguration(CONFIG_OPENAI_MODEL) as string) || 'gpt-5-mini';

    const payload = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'Return a concise lowercase filename with dashes only. Do not include extension, punctuation, code fences, quotes, or extra text.',
        },
        {
          role: 'user',
          content: `Suggest a filename for this ${fileExt || 'text'} scratchpad:\n\n${content}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 24,
    };

    try {
      const rawResponse = await this.postJSON('https://api.openai.com/v1/chat/completions', payload, {
        Authorization: `Bearer ${apiKey}`,
      });

      const response = JSON.parse(rawResponse) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const text = response.choices?.[0]?.message?.content;
      if (!text) {
        return undefined;
      }

      return this.sanitizeFilename(text);
    } catch {
      return undefined;
    }
  }

  private static sanitizeFilename(input: string): string | undefined {
    const firstLine = input.split('\n')[0] || '';
    const cleaned = firstLine
      .trim()
      .toLowerCase()
      .replace(/[`"']/g, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9\-\s_]/g, ' ')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    if (!cleaned) {
      return undefined;
    }

    return cleaned;
  }

  private static async postJSON(urlString: string, payload: object, headers: Record<string, string>): Promise<string> {
    const requestData = JSON.stringify(payload);
    const url = new URL(urlString);

    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: 'POST',
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestData),
            ...headers,
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`OpenAI request failed with status ${res.statusCode}: ${data}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.write(requestData);
      req.end();
    });
  }

  public static buildFinalFilename(baseName: string, currentFilePath: string): string {
    const ext = path.extname(currentFilePath);
    return `${baseName}${ext}`;
  }
}
