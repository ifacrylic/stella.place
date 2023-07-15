import { URLSearchParams } from 'node:url';
import fs from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { TranslationServiceClient } from '@google-cloud/translate';
import type { NotesRepository } from '@/models/index.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { MetaService } from '@/core/MetaService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { createTemp } from '@/misc/create-temp.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	res: {
		type: 'object',
		optional: false, nullable: false,
	},

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'bea9b03f-36e0-49c5-a4db-627a029f8971',
		},
		noTranslateService: {
			message: 'Translate service is not available.',
			code: 'NO_TRANSLATE_SERVICE',
			id: 'bef6e895-c05d-4499-9815-035ed18b0e31',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		targetLang: { type: 'string' },
	},
	required: ['noteId', 'targetLang'],
} as const;

// eslint-disable-next-line import/no-default-export
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private noteEntityService: NoteEntityService,
		private getterService: GetterService,
		private metaService: MetaService,
		private httpRequestService: HttpRequestService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (!(await this.noteEntityService.isVisibleForMe(note, me ? me.id : null))) {
				return 204; // TODO: 良い感じのエラー返す
			}

			if (note.text == null) {
				return 204;
			}

			const instance = await this.metaService.fetch();

			const translatorServices = [
				'deepl',
				'ctav3',
			];

			if (instance.translatorType == null || !translatorServices.includes(instance.translatorType)) {
				throw new ApiError(meta.errors.noTranslateService);
			}

			let targetLang = ps.targetLang;
			if (targetLang.includes('-')) targetLang = targetLang.split('-')[0];

			let translationResult;
			if (instance.translatorType === 'deepl') {
				if (instance.deeplAuthKey == null) {
					return 204; // TODO: 良い感じのエラー返す
				}
				translationResult = await this.translateDeepL(note.text, targetLang, instance.deeplAuthKey, instance.deeplIsPro, instance.translatorType);
			} else if (instance.translatorType === 'ctav3') {
				if (instance.ctav3SaKey == null) { return 204; } else if (instance.ctav3ProjectId == null) { return 204; }
				else if (instance.ctav3Location == null) { return 204; }
				translationResult = await this.apiCloudTranslationAdvanced(
					note.text, targetLang, instance.ctav3SaKey, instance.ctav3ProjectId, instance.ctav3Location, instance.ctav3Model, instance.ctav3Glossary, instance.translatorType,
				);
			} else {
				throw new Error('Unsupported translator type');
			}

			return {
				sourceLang: translationResult.sourceLang,
				text: translationResult.text,
				translator: translationResult.translator,
			};
		});
	}

	private async translateDeepL(text: string, targetLang: string, authKey: string, isPro: boolean, provider: string) {
		const params = new URLSearchParams();
		params.append('auth_key', authKey);
		params.append('text', text);
		params.append('target_lang', targetLang);

		const endpoint = isPro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';

		const res = await this.httpRequestService.send(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json, */*',
			},
			body: params.toString(),
		});

		const json = (await res.json()) as {
      translations: {
        detected_source_language: string;
        text: string;
      }[];
    };

		return {
			sourceLang: json.translations[0].detected_source_language,
			text: json.translations[0].text,
			translator: provider,
		};
	}

	private async apiCloudTranslationAdvanced(text: string, targetLang: string, saKey: string, projectId: string, location: string, model: string | null, glossary: string | null, provider: string) {
		const [path, cleanup] = await createTemp();
		fs.writeFileSync(path, saKey);

		const translationClient = new TranslationServiceClient({ keyFilename: path });

		const detectRequest = {
			parent: `projects/${projectId}/locations/${location}`,
			content: text,
		};

		let detectedLanguage = null;
		let glossaryConfig = null;
		if (glossary !== '' && glossary !== null) {
			glossaryConfig = {
				glossary: `projects/${projectId}/locations/${location}/glossaries/${glossary}`,
			};
			const [detectResponse] = await translationClient.detectLanguage(detectRequest);
			detectedLanguage = detectResponse.languages && detectResponse.languages[0]?.languageCode;
		}

		let modelConfig = null;
		if (model !== '' && model !== null) {
			modelConfig = `projects/${projectId}/locations/${location}/models/${model}`;
		}

		const translateRequest = {
			parent: `projects/${projectId}/locations/${location}`,
			contents: [text],
			mimeType: 'text/plain',
			sourceLanguageCode: null,
			targetLanguageCode: detectedLanguage !== null ? detectedLanguage : targetLang,
			model: modelConfig,
			glossaryConfig: glossaryConfig,
		};
		const [translateResponse] = await translationClient.translateText(translateRequest);
		const translatedText = translateResponse.translations && translateResponse.translations[0]?.translatedText;
		const detectedLanguageCode = translateResponse.translations && translateResponse.translations[0]?.detectedLanguageCode;

		cleanup();

		return {
			sourceLang: detectedLanguage !== null ? detectedLanguage : detectedLanguageCode,
			text: translatedText,
			translator: provider,
		};
	}
}
