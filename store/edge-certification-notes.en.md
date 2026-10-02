# Edge resubmission — Notes for Certification

Paste the text below into **Submission Options > Notes for Certification** for version **0.1.9**.
Keep production API keys and personal login credentials in their existing private storage.

---

BiliSkip offers a credential-free shared-cache mode. Reviewers can test the core ad markers, automatic skipping and undo features with the DeepSeek API Key field left empty. The public test video below was verified in a fresh Microsoft Edge profile, signed out of Bilibili, on October 2, 2026.

Test account: Not applicable. BiliSkip has no user-account system. Generating a new AI analysis is an optional bring-your-own-key feature that connects directly to the user's DeepSeek API account. DeepSeek API keys grant access to a metered third-party service and are tied to the account owner's billing; we keep reusable production credentials private. The following precomputed shared results provide a working, credential-free certification path.

Review steps:

1. Install version 0.1.9. Keep "Query shared cache" enabled. Leave the DeepSeek API Key empty and its subtitle-upload consent unchecked. Local speech transcription can stay at its default disabled setting.
2. Open https://www.bilibili.com/video/BV1Lmd2BAEad/ and wait for the video player and extension to load.
3. Open the BiliSkip toolbar popup. It should show shared-cache results for two ad ranges: 00:00.12–00:01.66 and 02:05.97–02:55.70. The primary button "查询共享缓存" refreshes shared results.
4. Enable automatic skipping, then seek to 02:20. The player should jump to approximately 02:55.75. "撤销跳过" restores the previous position. Seeking to 01:00 preserves that normal-content section.
5. Refresh the page to verify local-cache reuse. This entire review path makes zero DeepSeek model requests and requires zero API credit.

The optional local-ASR section also includes a separate, default-on transcript-sharing switch for accuracy evaluation. It applies to newly generated local transcripts; reviewers can disable it independently. The test path above uses the video's existing subtitles. Details are disclosed at https://biliskipad.bakapiano.com/privacy.html.
