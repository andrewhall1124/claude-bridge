// Friendly auto-generated session names, e.g. "robust-monkey", "amazing-elephant".

const ADJECTIVES = [
  "amazing", "robust", "brave", "calm", "clever", "cosmic", "crimson", "curious",
  "daring", "eager", "electric", "fancy", "fearless", "fluffy", "gentle", "giddy",
  "golden", "happy", "hidden", "humble", "icy", "jolly", "keen", "lively",
  "lucky", "lunar", "mellow", "mighty", "nimble", "noble", "plucky", "polished",
  "proud", "quiet", "rapid", "rustic", "shiny", "silent", "sleepy", "smooth",
  "snappy", "solar", "spry", "stellar", "sturdy", "swift", "tidy", "vivid",
  "witty", "zany",
];

const ANIMALS = [
  "monkey", "elephant", "otter", "falcon", "panda", "tiger", "koala", "lemur",
  "walrus", "badger", "beaver", "bison", "cheetah", "cobra", "dolphin", "ferret",
  "gecko", "gibbon", "heron", "ibex", "jaguar", "kestrel", "lynx", "macaw",
  "marmot", "narwhal", "ocelot", "osprey", "panther", "puffin", "quokka", "raccoon",
  "raven", "salmon", "seal", "stork", "tapir", "toucan", "viper", "wombat",
  "yak", "zebra",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function randomSessionName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}
