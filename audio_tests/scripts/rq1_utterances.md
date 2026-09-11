# RQ1 test set — code-switching WER baseline

Per PLAN.md RQ1: 30 utterances (10 clean English, 10 Manglish with
Malay/Mandarin/Hokkien switches, 10 with lobby noise), transcribed with
`speech_models: ["universal-3-5-pro", "universal-2"]`, hand-labeled
against ground truth, WER computed per bucket. This is the last unmet
piece of the Day 1-3 gate.

Content draws from the hotel-front-desk scenarios in PLAN.md (S1-S3) and
deliberately reuses `orchestrator/agent.py`'s `KEYTERMS` list (`1204`,
`0803`, `towel`, `toothbrush`, `char kuey teow`) in several utterances —
those are the ones RQ2 (keyterms before/after) should look at first,
since the bias list was built for exactly these terms. The rest of the
set is intentionally broader (other rooms, other dishes, other requests)
so RQ2's result isn't just "it works on the terms we already told it
about."

## How to record

- Format: WAV, mono, 16-bit PCM, one of {8000, 16000, 22050, 24000,
  32000, 44100, 48000} Hz — 16000 or higher recommended. Each clip
  80ms-120s (all of these are well under that).
- One file per utterance: `audio_tests/recordings/<id>.wav` (e.g. `a01.wav`).
- Read naturally, not robotically — don't over-enunciate the code-switch
  boundaries in bucket B, that's the whole point of the test.
- Bucket C: add real background noise while recording — lobby/cafe
  ambience playing nearby, TV in another room, foot traffic — not a
  studio-quiet room with noise added in post. The point is testing STT
  under conditions closer to an actual hotel phone line.
- After recording, **listen back and hand-label the `ground_truth`
  column** with what was *actually* said (not just this script's text —
  natural speech deviates: filler words, a swapped word, a dropped
  particle). WER is computed against that hand-label, not the script.

## Bucket A — clean English (10)

| id | script text | notes |
|---|---|---|
| a01 | Hi, can I get two extra towels sent up to room twelve oh four? | baseline keyterm test: room 1204, towel |
| a02 | Good evening, I'd like to order room service for room eight oh three, please. | baseline keyterm test: room 0803 |
| a03 | Could you send a toothbrush and a bottle of water to my room? | keyterm test: toothbrush |
| a04 | Hello, I'm checking on a delivery I ordered about ten minutes ago. | status-check phrasing |
| a05 | Actually, can you also add a hairdryer to that order before it leaves? | amendment phrasing (S4) |
| a06 | Please cancel the delivery to room eleven twenty, we don't need it anymore. | recall phrasing (S5), non-keyterm room |
| a07 | Is there any way to get char kuey teow delivered to the front desk area? | keyterm test: dish name |
| a08 | Good morning, could someone bring up a spare pillow and a blanket? | plain request, no keyterms |
| a09 | I called earlier about extra towels, has the robot left yet? | status-check + keyterm |
| a10 | We'd like to order nasi lemak and a pot of tea for two, room nine fifteen. | non-keyterm dish, tests generalization |

## Bucket B — Manglish, code-switched (10)

| id | script text | notes |
|---|---|---|
| b01 | Boss, can you hantar satu towel to my room ah, room one two oh four. | Malay ("hantar"="send", "satu"="one") + keyterm room/towel |
| b02 | Wah, then also I want the char kuey teow lah, room oh eight oh three. | Manglish particle "lah" + keyterm dish/room |
| b03 | Eh boss, gua punya toothbrush belum sampai leh, can check ah? | Hokkien ("gua"="I", "punya"="'s") + Malay + keyterm |
| b04 | Can add extra blanket tak, cuaca sejuk sikit malam ni. | mid-sentence Malay clause ("tak"="not/right?", "cuaca sejuk"="weather cold") |
| b05 | Boss ah, jangan lupa hantar dua towel, bukan satu, ok? | correction/amendment in Malay ("jangan lupa"="don't forget", "dua"="two") |
| b06 | Wo yao yi ge nasi lemak, then teh tarik satu, thank you ah. | Mandarin ("wo yao yi ge"="I want one") + Malay + English |
| b07 | Eh cancel lah that delivery, wo bu yao le, terima kasih. | Hokkien/Manglish + Mandarin ("wo bu yao le"="I don't want it anymore") + Malay thanks |
| b08 | Boss can hurry sikit tak, guest already waiting long long already. | Malay filler ("sikit"="a bit") in an otherwise English sentence |
| b09 | Room one two zero four ah, minta tambah toothbrush, can or not? | digit-by-digit room number + Malay request phrase |
| b10 | Aiyo forgot to say, also want roti canai one plate, fast fast ah. | Hokkien interjection "aiyo" + dish name + reduplication |

## Bucket C — with lobby background noise (10)

Same style of content as A/B, recorded with real ambient noise (see
"How to record" above) — the noise is the variable under test, not the
language mix.

| id | script text | notes |
|---|---|---|
| c01 | Hi, can you send two towels up to room twelve oh four please? | English, noisy |
| c02 | Boss, hantar satu char kuey teow to room oh eight oh three ah. | Manglish, noisy — keyterm stack |
| c03 | Sorry, can you repeat that, I'm calling from the lobby and it's quite loud here. | English, meta — explicitly loud environment |
| c04 | Can also add a toothbrush to that order, room eleven twenty, thanks. | English, noisy, non-keyterm room |
| c05 | Wo yao teh tarik and roti canai, fast a bit can or not? | Mandarin/Malay/English mix, noisy |
| c06 | Please cancel my earlier request, we found the towels already. | English, noisy, recall phrasing |
| c07 | Eh boss, dua towel tak cukup, need four now ah. | Manglish amendment, noisy |
| c08 | Is my delivery still coming? It's been quite a while already. | English status-check, noisy |
| c09 | Boss, room nine one five, minta nasi lemak dan teh tarik satu. | Manglish, noisy, non-keyterm dish/room |
| c10 | Can you check if the robot passed by yet, I didn't hear anything. | English status-check, noisy |

## After recording

1. Transcribe each `audio_tests/recordings/<id>.wav` via
   `speech_models: ["universal-3-5-pro", "universal-2"]` (see
   ARCHITECTURE.md's pre-recorded quick start).
2. Fill in `audio_tests/results.md`'s table (ground truth, hypothesis,
   per-utterance WER, per-bucket average).
3. RQ2 reruns this same set with `keyterms_prompt` set to
   `orchestrator/agent.py`'s `KEYTERMS` list and reports the WER delta —
   look at a01/a03/a07/b01/b02/b03/b09/c02/c04/c09 first, they're the
   ones built around those specific keyterms.
