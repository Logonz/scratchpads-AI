import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config } from './config';
import {
  CONFIG_OPENAI_API_KEY,
  CONFIG_OPENAI_MODEL,
  CONFIG_RENAME_PROVIDER,
  CONFIG_VERBOSE_LOGGING,
} from './consts';

export type RenameProvider = 'auto' | 'vscode' | 'openai';

export class AIFilenameService {
  private static log(message: string, ...meta: unknown[]): void {
    const verboseLogging = Config.getExtensionConfiguration(CONFIG_VERBOSE_LOGGING) as boolean;
    if (!verboseLogging) {
      return;
    }

    console.log('[Scratchpads]', message, ...meta);
  }

  private static warn(message: string, ...meta: unknown[]): void {
    console.warn('[Scratchpads]', message, ...meta);
  }

  public static async suggestFilename(content: string, fileExt: string): Promise<string | undefined> {
    const provider = (Config.getExtensionConfiguration(CONFIG_RENAME_PROVIDER) as RenameProvider) || 'auto';
    this.log('suggestFilename: starting suggestion', {
      provider,
      fileExt,
      contentLength: content.length,
      preview: content.slice(0, 120),
    });

    if (provider === 'vscode' || provider === 'auto') {
      this.log('suggestFilename: attempting VS Code LM provider');
      const vscodeSuggestion = await this.suggestWithVSCodeLM(content, fileExt);
      if (vscodeSuggestion) {
        this.log('suggestFilename: VS Code LM suggestion succeeded', { vscodeSuggestion });
        return vscodeSuggestion;
      }

      this.log('suggestFilename: VS Code LM suggestion unavailable, continuing fallback flow');
    }

    if (provider === 'openai' || provider === 'auto') {
      this.log('suggestFilename: attempting OpenAI provider');
      const openAISuggestion = await this.suggestWithOpenAI(content, fileExt);
      this.log('suggestFilename: OpenAI provider result', { openAISuggestion });
      return openAISuggestion;
    }

    this.log('suggestFilename: no provider path produced a suggestion');
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
        this.log('suggestWithVSCodeLM: vscode.lm or LanguageModelChatMessage API unavailable in this runtime');
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
        this.log('suggestWithVSCodeLM: selecting chat model with selector', selector);
        const [candidate] = await vscodeAny.lm.selectChatModels(selector);
        if (candidate) {
          this.log('suggestWithVSCodeLM: model found for selector', selector);
          model = candidate;
          break;
        }

        this.log('suggestWithVSCodeLM: no model found for selector', selector);
      }

      if (!model) {
        this.log('suggestWithVSCodeLM: no VS Code model available after all selectors');
        return undefined;
      }

      const prompt = [
        vscodeAny.LanguageModelChatMessage.User(
          `Generate a short, descriptive filename based on content. Respond with filename text only, no extension, no markdown, no quotes, lowercase with dashes only. Target extension: ${fileExt || 'none'}.`,
        ),
        vscodeAny.LanguageModelChatMessage.User(content),
      ];

      const tokenSource = new vscode.CancellationTokenSource();
      let output = '';
      try {
        const response = await model.sendRequest(prompt, {}, tokenSource.token);
        this.log('suggestWithVSCodeLM: request sent, collecting streamed response');
        for await (const fragment of response.text) {
          output += fragment;
        }
      } finally {
        tokenSource.dispose();
      }

      const sanitized = this.sanitizeFilename(output);
      this.log('suggestWithVSCodeLM: response completed', {
        rawOutput: output,
        sanitized,
      });

      return sanitized;
    } catch (error) {
      this.warn('suggestWithVSCodeLM: request failed', error);
      return undefined;
    }
  }

  private static async suggestWithOpenAI(content: string, fileExt: string): Promise<string | undefined> {
    const apiKey = (Config.getExtensionConfiguration(CONFIG_OPENAI_API_KEY) as string) || '';
    if (!apiKey) {
      this.warn('suggestWithOpenAI: OpenAI API key is not configured, skipping provider');
      return undefined;
    }

    const model = (Config.getExtensionConfiguration(CONFIG_OPENAI_MODEL) as string) || 'gpt-5-mini';
    this.log('suggestWithOpenAI: building request payload', {
      model,
      fileExt,
      contentLength: content.length,
      preview: content.slice(0, 120),
    });

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
      this.log('suggestWithOpenAI: sending request to OpenAI chat completions API');
      const rawResponse = await this.postJSON('https://api.openai.com/v1/chat/completions', payload, {
        Authorization: `Bearer ${apiKey}`,
      });
      this.log('suggestWithOpenAI: raw response received', {
        rawResponseLength: rawResponse.length,
        rawResponsePreview: rawResponse.slice(0, 300),
      });

      const response = JSON.parse(rawResponse) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const text = response.choices?.[0]?.message?.content;
      if (!text) {
        this.warn('suggestWithOpenAI: response missing choices[0].message.content');
        return undefined;
      }

      const sanitized = this.sanitizeFilename(text);
      this.log('suggestWithOpenAI: response parsed', {
        rawText: text,
        sanitized,
      });

      return sanitized;
    } catch (error) {
      this.warn('suggestWithOpenAI: request failed', error);
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
      .slice(0, 60)
      .replace(/^-|-$/g, '');

    if (!cleaned) {
      this.warn('sanitizeFilename: sanitized value is empty', { input });
      return undefined;
    }

    this.log('sanitizeFilename: sanitized filename computed', { input, cleaned });
    return cleaned;
  }

  private static async postJSON(urlString: string, payload: object, headers: Record<string, string>): Promise<string> {
    const requestData = JSON.stringify(payload);
    const url = new URL(urlString);
    const timeoutMs = 10000;
    this.log('postJSON: preparing request', {
      url: urlString,
      requestBytes: Buffer.byteLength(requestData),
    });

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
          this.log('postJSON: response stream opened', {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
          });
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              this.log('postJSON: request completed successfully', {
                statusCode: res.statusCode,
                responseBytes: data.length,
              });
              resolve(data);
            } else {
              this.warn('postJSON: request failed with non-2xx status', {
                statusCode: res.statusCode,
                responsePreview: data.slice(0, 300),
              });
              reject(new Error(`OpenAI request failed with status ${res.statusCode}: ${data}`));
            }
          });
        },
      );


      req.setTimeout(timeoutMs, () => {
        this.warn('postJSON: request timed out', { timeoutMs });
        req.destroy(new Error(`OpenAI request timed out after ${timeoutMs}ms`));
      });

      req.on('error', (error) => {
        this.warn('postJSON: request errored', error);
        reject(error);
      });
      req.write(requestData);
      req.end();
    });
  }

  public static buildFinalFilename(baseName: string, currentFilePath: string): string {
    const ext = path.extname(currentFilePath);
    return `${baseName}${ext}`;
  }
}
