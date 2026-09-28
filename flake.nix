{
  description = "Thanima Quiz - minimal anti-cheat quiz site dev environment";

  inputs = {
    # Plain tarball URL (not "github:") so this doesn't hit api.github.com's
    # rate-limited commit-resolution endpoint when locking the flake.
    nixpkgs.url = "https://github.com/NixOS/nixpkgs/archive/refs/heads/nixos-unstable.tar.gz";
  };

  outputs = { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs
        [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (system: f system);
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            buildInputs = [
              pkgs.nodejs_22
            ];

            shellHook = ''
              echo "Thanima Quiz dev shell - node $(node -v), npm $(npm -v)"
              echo "Run: npm install && npm start"
            '';
          };
        });
    };
}
