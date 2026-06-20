// Prefer a female English voice for turn-by-turn announcements.

const FEMALE_NAME =
  /samantha|victoria|karen|moira|kate|serena|martha|fiona|tessa|susan|anna|zira|salli|joanna|ivy|female|woman/i

function englishVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'))
}

export function pickFemaleVoice(): SpeechSynthesisVoice | null {
  const voices = englishVoices()
  if (!voices.length) return null

  const enGb = voices.filter((v) => v.lang.toLowerCase().startsWith('en-gb'))
  const pool = enGb.length ? enGb : voices

  return (
    pool.find((v) => FEMALE_NAME.test(v.name) || FEMALE_NAME.test(v.voiceURI)) ??
    pool.find((v) => !/daniel|alex|fred|male|man|david|tom/i.test(v.name)) ??
    pool[0] ??
    null
  )
}

export function bindFemaleVoice(utterance: SpeechSynthesisUtterance, voice: SpeechSynthesisVoice | null) {
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  } else {
    utterance.lang = 'en-GB'
  }
}
