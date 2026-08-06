declare module "pokersolver" {
  export class Hand {
    name: string;
    descr: string;
    cards: Array<{ value: string; suit: string }>;
    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
  }

  const solver: { Hand: typeof Hand };
  export default solver;
}
