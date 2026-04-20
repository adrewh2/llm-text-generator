import next from "eslint-config-next"
import coreWebVitals from "eslint-config-next/core-web-vitals"
import typescript from "eslint-config-next/typescript"

const config = [
  ...next,
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Disabled: we legitimately reset derived state inside effects
      // when keys/props change (see useVisibleStatus + ResultPane's
      // history-membership fetch). The React docs sanction this
      // pattern; the rule is too strict for it.
      "react-hooks/set-state-in-effect": "off",
      // Disabled: `useRef(createClient()).current` is our standard
      // idiom for one-shot lazy client construction (Supabase
      // browser clients). Reading the ref during render is safe
      // because the ref is set in the same render pass and never
      // mutated afterwards.
      "react-hooks/refs": "off",
    },
  },
]

export default config
