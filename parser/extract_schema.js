const schema = {
  chapter: "string",
  section: "string",
  core_concepts: [
    {
      term: "string",
      definition: "string",
      formula: "string (LaTeX preferred)"
    }
  ],
  engineering_context: "string (practical application or physical meaning)",
  visual_dependencies: "string (textual description of inferred circuit topology or graphs)",
  assessment: [
    {
      type: "multiple_choice | true_false | fill_blank",
      question: "string",
      options: [
        { text: "string", is_correct: "boolean", explanation: "string" }
      ],
      difficulty: "high | medium",
      confusing_factor: "string (why this question is tricky)"
    }
  ]
};
module.exports = schema;
