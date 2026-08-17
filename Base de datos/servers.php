// database/migrations/2026_08_16_000004_create_servers_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('servers', function (Blueprint $table) {
            $table->id();
            $table->string('uuid')->unique(); // ID único para carpetas y nombres de contenedor
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete(); // Dueño
            $table->foreignId('node_id')->constrained('nodes')->restrictOnDelete(); // Nodo en Azure
            $table->foreignId('plan_id')->constrained('plans')->restrictOnDelete();
            $table->string('project_name');
            $table->string('motd')->default('Professional Server');
            $table->enum('edition', ['java', 'bedrock'])->default('java');
            $table->string('software'); // Paper, Forge, Fabric, Purpur, Vanilla, etc.
            $table->string('version'); // 1.20.1, 1.21, etc.
            $table->integer('ram_allocated_gb');
            $table->integer('max_players');
            $table->string('public_ip')->nullable(); // IP entregada por Playit.gg
            $table->enum('status', ['installing', 'running', 'stopped', 'error'])->default('installing');
            $table->timestamps();
        });
    }

    public function down(): void {
        Schema::dropIfExists('servers');
    }
};