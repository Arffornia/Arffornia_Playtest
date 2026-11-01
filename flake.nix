{
  description = "Arffornia playtest kit: the `playtest` CLI (up, status, extend, down, checklist, card, guide, report)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: let
        kit = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type: let rel = pkgs.lib.removePrefix (toString ./. + "/") (toString path); in
            rel == "package.json" || rel == "kit" || rel == "checklists"
            || pkgs.lib.hasPrefix "kit/" rel || pkgs.lib.hasPrefix "checklists/" rel;
        };
      in rec {
        playtest = pkgs.writeShellApplication {
          name = "playtest";
          # The kit shells out to gh (REST only) and git; Java 21 runs `--local` environments.
          # The whole kit (lib/, checklists/) goes to the store, not only the entry file.
          runtimeInputs = [ pkgs.nodejs_22 pkgs.gh pkgs.git pkgs.jdk21_headless ];
          text = ''exec node ${kit}/kit/playtest.mjs "$@"'';
        };
        default = playtest;
      });

      apps = forAll (pkgs: rec {
        playtest = { type = "app"; program = "${self.packages.${pkgs.system}.playtest}/bin/playtest"; };
        default = playtest;
      });
    };
}
