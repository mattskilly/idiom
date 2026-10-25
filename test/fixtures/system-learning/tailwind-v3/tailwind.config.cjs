module.exports = {
  content: [],
  presets: [require("./preset.cjs")],
  theme: {
    spacing: { card: "8px", unused: "24px" },
    borderRadius: { button: "6px", unused: "12px" },
    colors: { brand: { DEFAULT: "#123456", unused: "#abcdef" } },
    height: ({ theme }) => ({
      button: "32px",
      "input-height": "40px",
      layout: theme("spacing.unused"),
    }),
    extend: { spacing: { compact: "4px" } },
  },
};
