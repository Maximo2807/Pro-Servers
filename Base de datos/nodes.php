// database/migrations/2026_08_16_000002_create_nodes_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('nodes', function (Blueprint $table) {
            $table->id();
            $table->string('name'); // Ej: Azure-EastUS-Node-01
            $table->string('ip_address'); // IP Privada de la VM en Azure
            $table->integer('port')->default(3000); // Puerto del Daemon Node.js
            $table->string('daemon_secret'); // Token de autenticación Master-Daemon
            $table->integer('total_ram_gb'); // Capacidad física del nodo (ej: 64, 128, 256)
            $table->integer('allocated_ram_gb')->default(0); // RAM comprometida actualmente
            $table->boolean('is_online')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void {
        Schema::dropIfExists('nodes');
    }
};