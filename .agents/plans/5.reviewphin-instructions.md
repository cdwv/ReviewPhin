Our current setup should already support project knowledge from instructions like `AGENTS.md` or from memory. 

However, developers may need a way to add instruction.md files that apply only to reviewphin.

Idea:

- Add support for `.reviewphin` or `.agents/review` directory (are there better alternatves?)
- Read instructions from all default locations plus `.reviewphin` or `.agents/review`