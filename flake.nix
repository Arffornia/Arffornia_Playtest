{
  description = "Arffornia PR playtest kit: the `playtest` CLI (guide, up, down, report)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        playtest = pkgs.writeShellApplication {
          name = "playtest";
          # The kit shells out to gh (REST only) and git; Java 21 runs local environments.
          runtimeInputs = [ pkgs.nodejs_22 pkgs.gh pkgs.git pkgs.jdk21_headless ];
          text = ''exec node ${./kit/playtest.mjs} "$@"'';
        };
        default = playtest;
      });

      apps = forAll (pkgs: rec {
        playtest = { type = "app"; program = "${self.packages.${pkgs.system}.playtest}/bin/playtest"; };
        default = playtest;
      });
    };
}
